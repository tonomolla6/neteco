<script setup lang="ts">
import { ref, onMounted } from 'vue'
import type { CarrierScorecardReport } from '../../workers/fulfillment/carrier-scorecard'

defineProps<{
  runtime?: unknown
}>()

const requestFetch = useRequestFetch()

const loading = ref(true)
const error = ref<string | null>(null)
const data = ref<CarrierScorecardReport | null>(null)

// Default range: last 30 days
const now = new Date()
const thirtyDaysAgo = new Date(now.getTime() - 30 * 86400000)

const fromDate = ref(thirtyDaysAgo.toISOString().slice(0, 10))
const toDate = ref(now.toISOString().slice(0, 10))
const selectedCarrier = ref('all')

async function fetchScorecard() {
  loading.value = true
  error.value = null

  try {
    const fromIso = `${fromDate.value}T00:00:00Z`
    const toIso = `${toDate.value}T23:59:59Z`

    const response = await requestFetch<CarrierScorecardReport>('/api/admin/carriers/scorecard', {
      method: 'GET',
      query: {
        from: fromIso,
        to: toIso,
        carrier: selectedCarrier.value
      }
    })

    data.value = response
  } catch {
    error.value = 'No se ha podido cargar el scorecard de transportistas. Comprueba tus permisos de administración.'
  } finally {
    loading.value = false
  }
}

function setPreset(days: number) {
  const end = new Date()
  const start = new Date(end.getTime() - days * 86400000)
  fromDate.value = start.toISOString().slice(0, 10)
  toDate.value = end.toISOString().slice(0, 10)
  void fetchScorecard()
}

function formatPercent(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return '—'
  return `${(value * 100).toFixed(1)}%`
}

function formatEuros(cents: number | null): string {
  if (cents === null || !Number.isFinite(cents)) return '—'
  return (cents / 100).toLocaleString('es-ES', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' €'
}

function formatHours(hours: number | null): string {
  if (hours === null || !Number.isFinite(hours)) return '—'
  return `${hours.toFixed(1)} h`
}

onMounted(() => {
  void fetchScorecard()
})
</script>

<template>
  <div class="mx-auto max-w-7xl px-4 py-6 sm:px-6 lg:px-8 space-y-8">
    <!-- Header -->
    <div class="border-b border-slate-200 pb-5">
      <div class="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 class="text-2xl font-bold text-slate-900 sm:text-3xl">Scorecard de transportistas</h1>
          <p class="mt-1 text-sm text-slate-600">
            Métricas de calidad y resiliencia de envíos: puntualidad, daños, incidencias, primera entrega y estado de
            circuit breaker.
          </p>
        </div>
        <div class="flex items-center gap-2">
          <NuxtLink
            to="/admin/operaciones"
            class="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700 shadow-sm hover:bg-slate-50 transition"
          >
            Operaciones y expedición
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
          <label for="filter-carrier" class="block text-xs font-semibold text-slate-600 uppercase tracking-wider mb-1">
            Transportista
          </label>
          <select
            id="filter-carrier"
            v-model="selectedCarrier"
            data-filter="carrier"
            class="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-800 shadow-sm focus:border-neteco-500 focus:ring-1 focus:ring-neteco-500"
          >
            <option value="all">Todos los transportistas</option>
            <option value="correos_express">Correos Express</option>
            <option value="gls">GLS Spain</option>
            <option value="dhl">DHL Parcel</option>
            <option value="seur">SEUR</option>
            <option value="own_delivery">Reparto propio</option>
          </select>
        </div>

        <div class="flex items-center gap-1.5 self-end">
          <button
            type="button"
            class="rounded-lg border border-slate-200 bg-slate-50 px-2.5 py-2 text-xs font-medium text-slate-700 hover:bg-slate-100 transition"
            @click="setPreset(7)"
          >
            7 días
          </button>
          <button
            type="button"
            class="rounded-lg border border-slate-200 bg-slate-50 px-2.5 py-2 text-xs font-medium text-slate-700 hover:bg-slate-100 transition"
            @click="setPreset(30)"
          >
            30 días
          </button>
          <button
            type="button"
            class="rounded-lg border border-slate-200 bg-slate-50 px-2.5 py-2 text-xs font-medium text-slate-700 hover:bg-slate-100 transition"
            @click="setPreset(90)"
          >
            90 días
          </button>
        </div>

        <button
          type="button"
          data-action="apply-filters"
          class="rounded-lg bg-slate-900 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-slate-800 transition"
          @click="fetchScorecard"
        >
          Aplicar filtros
        </button>
      </div>
    </div>

    <!-- Loading State -->
    <div v-if="loading" class="flex justify-center py-12">
      <div class="text-sm font-medium text-slate-500">Cargando métricas de transportistas...</div>
    </div>

    <!-- Error State -->
    <div v-else-if="error" class="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-700">
      {{ error }}
    </div>

    <!-- Empty State -->
    <div
      v-else-if="!data || data.summary.totalShipments === 0"
      class="rounded-xl border border-slate-200 bg-white p-12 text-center shadow-sm"
    >
      <h3 class="text-base font-semibold text-slate-900">Sin envíos registrados</h3>
      <p class="mt-1 text-sm text-slate-500">
        No hay datos de envíos en el período seleccionado. Ajusta los filtros para consultar otro intervalo.
      </p>
    </div>

    <!-- Scorecard Content -->
    <div v-else class="space-y-8">
      <!-- KPI Cards Grid -->
      <div class="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-6">
        <!-- Total Envíos -->
        <div class="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
          <div class="text-xs font-semibold text-slate-500 uppercase tracking-wider">Total Envíos</div>
          <div class="mt-2 text-2xl font-bold text-slate-900">
            {{ data.summary.totalShipments }}
          </div>
          <div class="mt-1 text-xs text-slate-500">{{ data.summary.deliveredShipments }} entregados</div>
        </div>

        <!-- Entrega a tiempo -->
        <div class="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
          <div class="text-xs font-semibold text-slate-500 uppercase tracking-wider">Entrega a tiempo</div>
          <div
            class="mt-2 text-2xl font-bold"
            :class="(data.summary.onTimeRate ?? 0) >= 0.95 ? 'text-emerald-600' : 'text-amber-600'"
          >
            {{ formatPercent(data.summary.onTimeRate) }}
          </div>
          <div class="mt-1 text-xs text-slate-500">SLA objetivo: ≥ 95%</div>
        </div>

        <!-- Primera entrega -->
        <div class="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
          <div class="text-xs font-semibold text-slate-500 uppercase tracking-wider">Primera entrega</div>
          <div
            class="mt-2 text-2xl font-bold"
            :class="(data.summary.firstAttemptRate ?? 0) >= 0.85 ? 'text-emerald-600' : 'text-amber-600'"
          >
            {{ formatPercent(data.summary.firstAttemptRate) }}
          </div>
          <div class="mt-1 text-xs text-slate-500">Éxito en 1er intento</div>
        </div>

        <!-- Incidencias -->
        <div class="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
          <div class="text-xs font-semibold text-slate-500 uppercase tracking-wider">Tasa incidencias</div>
          <div
            class="mt-2 text-2xl font-bold"
            :class="(data.summary.incidentRate ?? 0) <= 0.05 ? 'text-emerald-600' : 'text-rose-600'"
          >
            {{ formatPercent(data.summary.incidentRate) }}
          </div>
          <div class="mt-1 text-xs text-slate-500">Ausencias, retrasos, etc.</div>
        </div>

        <!-- Daños -->
        <div class="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
          <div class="text-xs font-semibold text-slate-500 uppercase tracking-wider">Tasa de daños</div>
          <div
            class="mt-2 text-2xl font-bold"
            :class="(data.summary.damageRate ?? 0) <= 0.01 ? 'text-emerald-600' : 'text-rose-600'"
          >
            {{ formatPercent(data.summary.damageRate) }}
          </div>
          <div class="mt-1 text-xs text-slate-500">Roturas y derrames</div>
        </div>

        <!-- Coste medio -->
        <div class="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
          <div class="text-xs font-semibold text-slate-500 uppercase tracking-wider">Coste medio</div>
          <div class="mt-2 text-2xl font-bold text-slate-900">
            {{ formatEuros(data.summary.averageCostCents) }}
          </div>
          <div class="mt-1 text-xs text-slate-500">Res: {{ formatHours(data.summary.averageResolutionTimeHours) }}</div>
        </div>
      </div>

      <!-- Carrier Breakdown Table -->
      <div class="rounded-xl border border-slate-200 bg-white shadow-sm overflow-hidden">
        <div class="px-6 py-4 border-b border-slate-200 bg-slate-50 flex items-center justify-between">
          <h2 class="text-base font-semibold text-slate-900">Desglose por transportista</h2>
          <span class="text-xs font-medium text-slate-500">
            Umbral de muestra estadística: {{ data.minSampleThreshold }} envíos
          </span>
        </div>

        <div class="overflow-x-auto">
          <table class="min-w-full divide-y divide-slate-200 text-left text-sm">
            <thead class="bg-slate-50 text-xs font-semibold text-slate-600 uppercase tracking-wider">
              <tr>
                <th scope="col" class="px-6 py-3">Transportista</th>
                <th scope="col" class="px-6 py-3">Circuit Breaker</th>
                <th scope="col" class="px-6 py-3 text-right">Envíos</th>
                <th scope="col" class="px-6 py-3 text-right">A tiempo</th>
                <th scope="col" class="px-6 py-3 text-right">1ª entrega</th>
                <th scope="col" class="px-6 py-3 text-right">Incidencias</th>
                <th scope="col" class="px-6 py-3 text-right">Daños</th>
                <th scope="col" class="px-6 py-3 text-right">Coste medio</th>
                <th scope="col" class="px-6 py-3 text-right">Tiempo res.</th>
              </tr>
            </thead>
            <tbody class="divide-y divide-slate-200 bg-white">
              <tr v-for="item in data.carriers" :key="item.carrier" class="hover:bg-slate-50 transition">
                <!-- Carrier Name & Sample Warning -->
                <td class="px-6 py-4 font-medium text-slate-900 whitespace-nowrap">
                  <div class="flex items-center gap-2">
                    <span>{{ item.carrierName }}</span>
                    <span
                      v-if="!item.hasSufficientSample"
                      class="inline-flex items-center rounded-md bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-700 ring-1 ring-inset ring-amber-600/20"
                      title="Muestra estadística insuficiente (< 10 envíos)"
                    >
                      Muestra baja (&lt; 10)
                    </span>
                  </div>
                </td>

                <!-- Circuit Breaker Status Badge -->
                <td class="px-6 py-4 whitespace-nowrap">
                  <span
                    v-if="item.circuitBreaker?.state === 'closed'"
                    class="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2.5 py-0.5 text-xs font-semibold text-emerald-700 ring-1 ring-inset ring-emerald-600/20"
                  >
                    <span class="h-1.5 w-1.5 rounded-full bg-emerald-600"></span>
                    Cerrado (Normal)
                  </span>
                  <span
                    v-else-if="item.circuitBreaker?.state === 'half_open'"
                    class="inline-flex items-center gap-1 rounded-full bg-amber-50 px-2.5 py-0.5 text-xs font-semibold text-amber-700 ring-1 ring-inset ring-amber-600/20"
                  >
                    <span class="h-1.5 w-1.5 rounded-full bg-amber-600"></span>
                    Semiabierto (Prueba)
                  </span>
                  <span
                    v-else-if="item.circuitBreaker?.state === 'open'"
                    class="inline-flex items-center gap-1 rounded-full bg-rose-50 px-2.5 py-0.5 text-xs font-semibold text-rose-700 ring-1 ring-inset ring-rose-600/20"
                  >
                    <span class="h-1.5 w-1.5 rounded-full bg-rose-600"></span>
                    Abierto (Fallo)
                  </span>
                  <span v-else class="text-xs text-slate-400">—</span>
                </td>

                <!-- Total Shipments -->
                <td class="px-6 py-4 text-right whitespace-nowrap text-slate-700 font-semibold">
                  {{ item.totalShipments }}
                </td>

                <!-- On-Time % -->
                <td class="px-6 py-4 text-right whitespace-nowrap font-medium text-slate-700">
                  {{ formatPercent(item.onTimeRate) }}
                </td>

                <!-- First Attempt % -->
                <td class="px-6 py-4 text-right whitespace-nowrap font-medium text-slate-700">
                  {{ formatPercent(item.firstAttemptRate) }}
                </td>

                <!-- Incidents % -->
                <td class="px-6 py-4 text-right whitespace-nowrap font-medium text-slate-700">
                  {{ formatPercent(item.incidentRate) }}
                </td>

                <!-- Damage % -->
                <td class="px-6 py-4 text-right whitespace-nowrap font-medium text-slate-700">
                  {{ formatPercent(item.damageRate) }}
                </td>

                <!-- Average Cost -->
                <td class="px-6 py-4 text-right whitespace-nowrap font-medium text-slate-700">
                  {{ formatEuros(item.averageCostCents) }}
                </td>

                <!-- Average Resolution Time -->
                <td class="px-6 py-4 text-right whitespace-nowrap font-medium text-slate-700">
                  {{ formatHours(item.averageResolutionTimeHours) }}
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>
  </div>
</template>

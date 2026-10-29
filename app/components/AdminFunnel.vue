<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import type { FunnelAnalyticsDashboardResponse } from '../../workers/analytics/funnel'

const props = defineProps<{ runtime: unknown }>()
const { ready, loggedIn, user } = useUserSession()
const requestFetch = useRequestFetch()

const fromDate = ref('')
const toDate = ref('')
const selectedDevice = ref<'all' | 'desktop' | 'mobile' | 'tablet'>('all')
const selectedSource = ref<'all' | 'direct' | 'organic' | 'cpc' | 'social' | 'email' | 'referral' | 'other'>('all')
const selectedSegment = ref<'all' | 'anonymous' | 'customer' | 'professional'>('all')

const loading = ref(false)
const error = ref<string | null>(null)
const data = ref<FunnelAnalyticsDashboardResponse | null>(null)

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

function formatWilsonInterval(lower: number, upper: number): string {
  return `[${(lower * 100).toFixed(1)}% - ${(upper * 100).toFixed(1)}%]`
}

async function fetchFunnel() {
  if (!isAuthorized.value) return
  loading.value = true
  error.value = null

  try {
    const params = new URLSearchParams()
    if (fromDate.value) params.set('from', `${fromDate.value}T00:00:00Z`)
    if (toDate.value) params.set('to', `${toDate.value}T23:59:59Z`)
    if (selectedDevice.value !== 'all') params.set('device', selectedDevice.value)
    if (selectedSource.value !== 'all') params.set('source', selectedSource.value)
    if (selectedSegment.value !== 'all') params.set('segment', selectedSegment.value)

    const response = await requestFetch<FunnelAnalyticsDashboardResponse>(
      `/api/admin/analytics/funnel${params.toString() ? `?${params.toString()}` : ''}`,
      { method: 'GET' }
    )
    data.value = response
  } catch (err: unknown) {
    error.value = err instanceof Error ? err.message : 'Error al cargar el embudo de conversión'
  } finally {
    loading.value = false
  }
}

onMounted(() => {
  if (isAuthorized.value) {
    void fetchFunnel()
  }
})
</script>

<template>
  <div class="space-y-6">
    <div class="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
      <div>
        <h2 class="text-xl font-bold text-slate-900 flex items-center gap-2">
          Embudo de conversión
          <span class="rounded bg-indigo-100 px-2 py-0.5 text-xs font-semibold text-indigo-800">DAT-015</span>
        </h2>
        <p class="text-sm text-slate-500">
          Trayectoria visita → ficha → carrito → checkout → pago con intervalos de confianza Wilson y sin PII.
        </p>
      </div>

      <button
        type="button"
        class="inline-flex items-center justify-center rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-indigo-700 disabled:opacity-50"
        :disabled="loading || !isAuthorized"
        data-testid="funnel-refresh"
        @click="fetchFunnel"
      >
        <span v-if="loading">Cargando...</span>
        <span v-else>Actualizar</span>
      </button>
    </div>

    <!-- Filtros -->
    <div class="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
      <form class="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-6" @submit.prevent="fetchFunnel">
        <div>
          <label for="funnel-from" class="block text-xs font-medium text-slate-700">Desde</label>
          <input
            id="funnel-from"
            v-model="fromDate"
            type="date"
            class="mt-1 block w-full rounded-md border border-slate-300 px-3 py-1.5 text-sm shadow-sm focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
          />
        </div>

        <div>
          <label for="funnel-to" class="block text-xs font-medium text-slate-700">Hasta</label>
          <input
            id="funnel-to"
            v-model="toDate"
            type="date"
            class="mt-1 block w-full rounded-md border border-slate-300 px-3 py-1.5 text-sm shadow-sm focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
          />
        </div>

        <div>
          <label for="funnel-device" class="block text-xs font-medium text-slate-700">Dispositivo</label>
          <select
            id="funnel-device"
            v-model="selectedDevice"
            class="mt-1 block w-full rounded-md border border-slate-300 px-3 py-1.5 text-sm shadow-sm focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
          >
            <option value="all">Todos</option>
            <option value="desktop">Desktop</option>
            <option value="mobile">Mobile</option>
            <option value="tablet">Tablet</option>
          </select>
        </div>

        <div>
          <label for="funnel-source" class="block text-xs font-medium text-slate-700">Fuente</label>
          <select
            id="funnel-source"
            v-model="selectedSource"
            class="mt-1 block w-full rounded-md border border-slate-300 px-3 py-1.5 text-sm shadow-sm focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
          >
            <option value="all">Todas</option>
            <option value="direct">Directo</option>
            <option value="organic">Orgánico</option>
            <option value="cpc">CPC (Pago)</option>
            <option value="social">Social</option>
            <option value="email">Email</option>
            <option value="referral">Referido</option>
          </select>
        </div>

        <div>
          <label for="funnel-segment" class="block text-xs font-medium text-slate-700">Segmento</label>
          <select
            id="funnel-segment"
            v-model="selectedSegment"
            class="mt-1 block w-full rounded-md border border-slate-300 px-3 py-1.5 text-sm shadow-sm focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
          >
            <option value="all">Todos</option>
            <option value="anonymous">Anónimo</option>
            <option value="customer">Particular</option>
            <option value="professional">Profesional (B2B)</option>
          </select>
        </div>

        <div class="flex items-end">
          <button
            type="submit"
            class="w-full rounded-md bg-slate-900 px-4 py-2 text-sm font-semibold text-white shadow hover:bg-slate-800 disabled:opacity-50"
            :disabled="loading || !isAuthorized"
            data-testid="funnel-apply"
          >
            Consultar embudo
          </button>
        </div>
      </form>
    </div>

    <!-- Error state -->
    <div
      v-if="error"
      class="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700"
      role="alert"
      data-testid="funnel-error"
    >
      {{ error }}
    </div>

    <!-- Visualización del Embudo de 5 Pasos -->
    <div v-if="data" class="space-y-4">
      <div class="grid grid-cols-1 gap-3 sm:grid-cols-5">
        <div
          v-for="(s, idx) in data.steps"
          :key="s.step"
          class="relative flex flex-col justify-between rounded-xl border border-slate-200 bg-white p-4 shadow-sm"
          :data-testid="`funnel-step-${s.step}`"
        >
          <div>
            <div class="flex items-center justify-between">
              <span
                class="flex h-6 w-6 items-center justify-center rounded-full bg-slate-100 text-xs font-bold text-slate-700"
              >
                {{ idx + 1 }}
              </span>
              <span
                v-if="s.isSmallSampleWarning"
                class="rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-semibold text-amber-800"
                data-testid="funnel-sample-warning"
              >
                Muestra pequeña
              </span>
            </div>
            <h3 class="mt-2 text-sm font-bold text-slate-900">{{ s.name }}</h3>
            <p class="mt-1 text-2xl font-extrabold text-slate-900">{{ s.sessions }}</p>
            <p class="text-xs text-slate-400">sesiones únicas</p>
          </div>

          <div class="mt-4 border-t border-slate-100 pt-3 text-xs space-y-1">
            <div v-if="s.conversionFromPrevious.rate !== null" class="flex justify-between items-center">
              <span class="text-slate-500">Paso anterior:</span>
              <span class="font-bold text-indigo-600">{{ formatPercent(s.conversionFromPrevious.rate) }}</span>
            </div>
            <div v-if="s.conversionFromPrevious.rate !== null" class="text-[11px] text-slate-400 text-right">
              IC 95%: {{ formatWilsonInterval(s.conversionFromPrevious.lower, s.conversionFromPrevious.upper) }}
            </div>

            <div v-if="idx > 0" class="flex justify-between items-center pt-1 border-t border-dashed border-slate-100">
              <span class="text-slate-500">Desde visita:</span>
              <span class="font-semibold text-slate-700">{{ formatPercent(s.conversionFromStart.rate) }}</span>
            </div>
          </div>
        </div>
      </div>

      <!-- Resumen global de conversión -->
      <div
        class="rounded-xl border border-indigo-100 bg-indigo-50/50 p-4 shadow-sm flex flex-col sm:flex-row justify-between items-center gap-4"
      >
        <div>
          <h4 class="text-sm font-bold text-indigo-950">Conversión Global del Embudo (Visita → Pago)</h4>
          <p class="text-xs text-indigo-700">
            Estimación no sesgada con intervalo de confianza binomial de Wilson (nivel de confianza 95%).
          </p>
        </div>
        <div class="text-right">
          <p class="text-2xl font-black text-indigo-600">
            {{ formatPercent(data.overallConversion.rate) }}
          </p>
          <p class="text-xs text-indigo-700">
            IC 95%: {{ formatWilsonInterval(data.overallConversion.lower, data.overallConversion.upper) }}
          </p>
        </div>
      </div>

      <!-- Desgloses dimensionales -->
      <div class="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <!-- Por Dispositivo -->
        <div class="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
          <h4 class="text-sm font-bold text-slate-900 mb-3">Por Dispositivo</h4>
          <table class="w-full text-xs text-left">
            <thead class="text-slate-500 border-b">
              <tr>
                <th class="pb-2">Dispositivo</th>
                <th class="pb-2 text-right">Visitas</th>
                <th class="pb-2 text-right">Pagos</th>
                <th class="pb-2 text-right">Conv.</th>
              </tr>
            </thead>
            <tbody class="divide-y divide-slate-100">
              <tr v-for="item in data.breakdown.byDevice" :key="item.key">
                <td class="py-2 font-medium capitalize">{{ item.key }}</td>
                <td class="py-2 text-right text-slate-600">{{ item.sessions }}</td>
                <td class="py-2 text-right text-slate-600">{{ item.purchaseSessions }}</td>
                <td class="py-2 text-right font-bold text-indigo-600">{{ formatPercent(item.conversionRate) }}</td>
              </tr>
            </tbody>
          </table>
        </div>

        <!-- Por Fuente -->
        <div class="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
          <h4 class="text-sm font-bold text-slate-900 mb-3">Por Fuente de Adquisición</h4>
          <table class="w-full text-xs text-left">
            <thead class="text-slate-500 border-b">
              <tr>
                <th class="pb-2">Fuente</th>
                <th class="pb-2 text-right">Visitas</th>
                <th class="pb-2 text-right">Pagos</th>
                <th class="pb-2 text-right">Conv.</th>
              </tr>
            </thead>
            <tbody class="divide-y divide-slate-100">
              <tr v-for="item in data.breakdown.bySource" :key="item.key">
                <td class="py-2 font-medium capitalize">{{ item.key }}</td>
                <td class="py-2 text-right text-slate-600">{{ item.sessions }}</td>
                <td class="py-2 text-right text-slate-600">{{ item.purchaseSessions }}</td>
                <td class="py-2 text-right font-bold text-indigo-600">{{ formatPercent(item.conversionRate) }}</td>
              </tr>
            </tbody>
          </table>
        </div>

        <!-- Por Segmento -->
        <div class="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
          <h4 class="text-sm font-bold text-slate-900 mb-3">Por Segmento de Usuario</h4>
          <table class="w-full text-xs text-left">
            <thead class="text-slate-500 border-b">
              <tr>
                <th class="pb-2">Segmento</th>
                <th class="pb-2 text-right">Visitas</th>
                <th class="pb-2 text-right">Pagos</th>
                <th class="pb-2 text-right">Conv.</th>
              </tr>
            </thead>
            <tbody class="divide-y divide-slate-100">
              <tr v-for="item in data.breakdown.bySegment" :key="item.key">
                <td class="py-2 font-medium capitalize">{{ item.key }}</td>
                <td class="py-2 text-right text-slate-600">{{ item.sessions }}</td>
                <td class="py-2 text-right text-slate-600">{{ item.purchaseSessions }}</td>
                <td class="py-2 text-right font-bold text-indigo-600">{{ formatPercent(item.conversionRate) }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import type { PaymentFunnelDashboardResponse } from '../../workers/payments/funnel-analytics'

const props = defineProps<{ runtime: unknown }>()
const { ready, loggedIn, user } = useUserSession()
const requestFetch = useRequestFetch()

const fromDate = ref('')
const toDate = ref('')
const selectedDevice = ref<'all' | 'desktop' | 'mobile' | 'tablet' | 'unknown'>('all')
const selectedMethod = ref<'all' | 'card' | 'bizum' | 'bank_transfer'>('all')
const selectedBank = ref<string>('all')

const loading = ref(false)
const error = ref<string | null>(null)
const data = ref<PaymentFunnelDashboardResponse | null>(null)

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

async function fetchPaymentFunnel() {
  if (!isAuthorized.value) return
  loading.value = true
  error.value = null

  try {
    const params = new URLSearchParams()
    if (fromDate.value) params.set('from', `${fromDate.value}T00:00:00Z`)
    if (toDate.value) params.set('to', `${toDate.value}T23:59:59Z`)
    if (selectedDevice.value !== 'all') params.set('device', selectedDevice.value)
    if (selectedMethod.value !== 'all') params.set('method', selectedMethod.value)
    if (selectedBank.value !== 'all') params.set('bank', selectedBank.value)

    const response = await requestFetch<PaymentFunnelDashboardResponse>(
      `/api/admin/payments/funnel${params.toString() ? `?${params.toString()}` : ''}`,
      { method: 'GET' }
    )
    data.value = response
  } catch (err: unknown) {
    error.value = err instanceof Error ? err.message : 'Error al cargar el funnel de pago'
  } finally {
    loading.value = false
  }
}

onMounted(() => {
  if (isAuthorized.value) {
    void fetchPaymentFunnel()
  }
})
</script>

<template>
  <div class="space-y-6">
    <!-- Header -->
    <div class="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
      <div>
        <div class="flex items-center gap-2 flex-wrap">
          <h2 class="text-xl font-bold text-slate-900">Funnel de pago y causas de rechazo</h2>
          <span class="rounded bg-indigo-100 px-2 py-0.5 text-xs font-semibold text-indigo-800">PAY-018</span>
          <span
            data-testid="payment-funnel-privacy-notice"
            class="rounded bg-emerald-100 px-2 py-0.5 text-xs font-semibold text-emerald-800"
          >
            Sin datos prohibidos (PAN, CVV, PIN, PII)
          </span>
        </div>
        <p class="text-sm text-slate-500 mt-1">
          Seguimiento de intentos de pago, pasarela y clasificación de denegaciones segmentadas por dispositivo, método
          y banco.
        </p>
      </div>

      <button
        type="button"
        class="inline-flex items-center justify-center rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-indigo-700 disabled:opacity-50 transition-colors"
        :disabled="loading || !isAuthorized"
        data-testid="payment-funnel-refresh"
        @click="fetchPaymentFunnel"
      >
        <span v-if="loading">Cargando...</span>
        <span v-else>Actualizar</span>
      </button>
    </div>

    <!-- Filtros -->
    <div class="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
      <form class="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-6" @submit.prevent="fetchPaymentFunnel">
        <div>
          <label for="payment-funnel-from" class="block text-xs font-medium text-slate-700">Desde</label>
          <input
            id="payment-funnel-from"
            v-model="fromDate"
            type="date"
            class="mt-1 block w-full rounded-md border border-slate-300 px-3 py-1.5 text-sm shadow-sm focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
          />
        </div>

        <div>
          <label for="payment-funnel-to" class="block text-xs font-medium text-slate-700">Hasta</label>
          <input
            id="payment-funnel-to"
            v-model="toDate"
            type="date"
            class="mt-1 block w-full rounded-md border border-slate-300 px-3 py-1.5 text-sm shadow-sm focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
          />
        </div>

        <div>
          <label for="payment-funnel-device" class="block text-xs font-medium text-slate-700">Dispositivo</label>
          <select
            id="payment-funnel-device"
            v-model="selectedDevice"
            class="mt-1 block w-full rounded-md border border-slate-300 px-3 py-1.5 text-sm shadow-sm focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
          >
            <option value="all">Todos</option>
            <option value="desktop">Ordenador (Desktop)</option>
            <option value="mobile">Móvil (Mobile)</option>
            <option value="tablet">Tablet</option>
            <option value="unknown">Desconocido</option>
          </select>
        </div>

        <div>
          <label for="payment-funnel-method" class="block text-xs font-medium text-slate-700">Método de pago</label>
          <select
            id="payment-funnel-method"
            v-model="selectedMethod"
            class="mt-1 block w-full rounded-md border border-slate-300 px-3 py-1.5 text-sm shadow-sm focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
          >
            <option value="all">Todos</option>
            <option value="card">Tarjeta</option>
            <option value="bizum">Bizum</option>
            <option value="bank_transfer">Transferencia</option>
          </select>
        </div>

        <div>
          <label for="payment-funnel-bank" class="block text-xs font-medium text-slate-700">Banco emisor</label>
          <select
            id="payment-funnel-bank"
            v-model="selectedBank"
            class="mt-1 block w-full rounded-md border border-slate-300 px-3 py-1.5 text-sm shadow-sm focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
          >
            <option value="all">Todos</option>
            <option value="BBVA">BBVA</option>
            <option value="Santander">Santander</option>
            <option value="CaixaBank">CaixaBank</option>
            <option value="Sabadell">Banco Sabadell</option>
            <option value="Bankinter">Bankinter</option>
            <option value="Otro">Otro</option>
          </select>
        </div>

        <div class="flex items-end">
          <button
            type="submit"
            class="w-full rounded-md bg-slate-900 px-4 py-2 text-sm font-semibold text-white shadow hover:bg-slate-800 disabled:opacity-50 transition-colors"
            :disabled="loading || !isAuthorized"
            data-testid="payment-funnel-apply"
            @click="fetchPaymentFunnel"
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
      data-testid="payment-funnel-error"
    >
      {{ error }}
    </div>

    <!-- Contenido cuando hay datos -->
    <div v-if="data" class="space-y-6">
      <!-- Tarjetas de Resumen Ejecutivo -->
      <div class="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5">
        <div class="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
          <span class="text-xs font-medium text-slate-500 uppercase tracking-wider">Intentos Totales</span>
          <p class="mt-1 text-2xl font-bold text-slate-900" data-testid="summary-total-attempts">
            {{ data.summary.totalAttempts }}
          </p>
          <span class="text-xs text-slate-400">100% inicio pago</span>
        </div>

        <div class="rounded-xl border border-emerald-200 bg-emerald-50/40 p-4 shadow-sm">
          <span class="text-xs font-medium text-emerald-800 uppercase tracking-wider">Autorizados / Éxito</span>
          <p class="mt-1 text-2xl font-bold text-emerald-700" data-testid="summary-authorized">
            {{ data.summary.authorizedCount }}
          </p>
          <span class="text-xs text-emerald-600">Cobros efectivos</span>
        </div>

        <div class="rounded-xl border border-indigo-200 bg-indigo-50/40 p-4 shadow-sm">
          <span class="text-xs font-medium text-indigo-800 uppercase tracking-wider">Tasa de Conversión</span>
          <p class="mt-1 text-2xl font-bold text-indigo-700" data-testid="summary-success-rate">
            {{ formatPercent(data.summary.authorizationRate) }}
          </p>
          <span
            class="text-xs text-indigo-600"
            :title="`Intervalo Wilson 95%: ${formatWilsonInterval(data.summary.wilsonInterval.lower, data.summary.wilsonInterval.upper)}`"
          >
            IC: {{ formatWilsonInterval(data.summary.wilsonInterval.lower, data.summary.wilsonInterval.upper) }}
          </span>
        </div>

        <div class="rounded-xl border border-red-200 bg-red-50/40 p-4 shadow-sm">
          <span class="text-xs font-medium text-red-800 uppercase tracking-wider">Tasa de Rechazo</span>
          <p class="mt-1 text-2xl font-bold text-red-700" data-testid="summary-decline-rate">
            {{ formatPercent(data.summary.declineRate) }}
          </p>
          <span class="text-xs text-red-600">{{ data.summary.declinedCount }} denegaciones</span>
        </div>

        <div class="rounded-xl border border-amber-200 bg-amber-50/40 p-4 shadow-sm">
          <span class="text-xs font-medium text-amber-800 uppercase tracking-wider">Cancelaciones / Abandono</span>
          <p class="mt-1 text-2xl font-bold text-amber-700" data-testid="summary-cancellation-rate">
            {{ formatPercent(data.summary.cancellationRate) }}
          </p>
          <span class="text-xs text-amber-600">{{ data.summary.cancelledCount }} abandonos</span>
        </div>
      </div>

      <!-- Embudo visual de 3 etapas -->
      <div class="rounded-xl border border-slate-200 bg-white p-6 shadow-sm space-y-4">
        <h3 class="text-base font-semibold text-slate-900">Etapas del Embudo de Pago</h3>

        <div class="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <div
            v-for="(st, idx) in data.stages"
            :key="st.step"
            class="relative flex flex-col justify-between rounded-xl border border-slate-200 bg-slate-50/50 p-4"
            :data-testid="`funnel-step-${st.step}`"
          >
            <div>
              <div class="flex items-center justify-between">
                <span
                  class="flex h-6 w-6 items-center justify-center rounded-full bg-slate-200 text-xs font-bold text-slate-700"
                >
                  {{ idx + 1 }}
                </span>
                <span
                  v-if="st.isSmallSampleWarning"
                  class="rounded bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-800"
                  data-testid="funnel-sample-warning"
                >
                  Muestra &lt; 30
                </span>
              </div>
              <h4 class="mt-2 text-sm font-semibold text-slate-900">{{ st.name }}</h4>
              <p class="mt-1 text-2xl font-bold text-slate-900">{{ st.count }}</p>
            </div>

            <div class="mt-4 border-t border-slate-200 pt-3 text-xs text-slate-500 space-y-1">
              <div class="flex justify-between">
                <span>Paso anterior:</span>
                <span class="font-medium text-slate-700">{{ formatPercent(st.conversionFromPrevious.rate) }}</span>
              </div>
              <div class="flex justify-between">
                <span>Desde inicio:</span>
                <span class="font-medium text-slate-700">{{ formatPercent(st.conversionFromStart.rate) }}</span>
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- Causas de Rechazo (Decline Reasons Table) -->
      <div class="rounded-xl border border-slate-200 bg-white p-6 shadow-sm space-y-4">
        <div class="flex items-center justify-between">
          <div>
            <h3 class="text-base font-semibold text-slate-900">Causas de Rechazo y Denegación</h3>
            <p class="text-xs text-slate-500">
              Desglose clasificado por código de respuesta de pasarela y motivo de fallo.
            </p>
          </div>
          <span class="rounded bg-red-100 px-2.5 py-1 text-xs font-semibold text-red-800">
            {{ data.summary.declinedCount }} rechazos totales
          </span>
        </div>

        <div v-if="data.declineCauses.length === 0" class="py-8 text-center text-sm text-slate-400">
          No hay rechazos registrados en el período seleccionado.
        </div>

        <div v-else class="overflow-x-auto">
          <table class="w-full text-left text-sm text-slate-700" data-testid="payment-decline-causes-table">
            <thead class="border-b border-slate-200 bg-slate-50 text-xs uppercase font-medium text-slate-500">
              <tr>
                <th scope="col" class="px-4 py-3">Motivo / Causa de rechazo</th>
                <th scope="col" class="px-4 py-3">Código Pasarela</th>
                <th scope="col" class="px-4 py-3 text-right">Intentos</th>
                <th scope="col" class="px-4 py-3 text-right">% sobre Rechazos</th>
                <th scope="col" class="px-4 py-3 w-1/4">Distribución</th>
              </tr>
            </thead>
            <tbody class="divide-y divide-slate-100">
              <tr
                v-for="cause in data.declineCauses"
                :key="`${cause.category}-${cause.code}`"
                class="hover:bg-slate-50/50"
              >
                <td class="px-4 py-3 font-medium text-slate-900">{{ cause.label }}</td>
                <td class="px-4 py-3 font-mono text-xs text-slate-500">{{ cause.code }}</td>
                <td class="px-4 py-3 text-right font-semibold text-slate-900">{{ cause.count }}</td>
                <td class="px-4 py-3 text-right font-medium text-red-600">{{ formatPercent(cause.percentage) }}</td>
                <td class="px-4 py-3">
                  <div class="h-2 w-full rounded-full bg-slate-100 overflow-hidden">
                    <div
                      class="h-full rounded-full bg-red-500"
                      :style="{ width: `${Math.min(100, Math.max(0, cause.percentage * 100))}%` }"
                    />
                  </div>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      <!-- Segmentaciones por Dimensión (Dispositivo, Método, Banco) -->
      <div class="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <!-- Por Dispositivo -->
        <div class="rounded-xl border border-slate-200 bg-white p-5 shadow-sm space-y-3">
          <h4 class="text-sm font-bold text-slate-900 uppercase tracking-wide">Por Dispositivo</h4>
          <table class="w-full text-left text-xs text-slate-700" data-testid="breakdown-device-table">
            <thead class="border-b border-slate-200 text-slate-400 uppercase font-medium">
              <tr>
                <th class="py-2">Dispositivo</th>
                <th class="py-2 text-right">Intentos</th>
                <th class="py-2 text-right">Éxito</th>
              </tr>
            </thead>
            <tbody class="divide-y divide-slate-100">
              <tr v-for="item in data.breakdowns.byDevice" :key="item.key">
                <td class="py-2.5 font-medium text-slate-800">{{ item.label }}</td>
                <td class="py-2.5 text-right font-semibold">{{ item.attempts }}</td>
                <td class="py-2.5 text-right font-medium text-emerald-600">{{ formatPercent(item.successRate) }}</td>
              </tr>
            </tbody>
          </table>
        </div>

        <!-- Por Método de pago -->
        <div class="rounded-xl border border-slate-200 bg-white p-5 shadow-sm space-y-3">
          <h4 class="text-sm font-bold text-slate-900 uppercase tracking-wide">Por Método de Pago</h4>
          <table class="w-full text-left text-xs text-slate-700" data-testid="breakdown-method-table">
            <thead class="border-b border-slate-200 text-slate-400 uppercase font-medium">
              <tr>
                <th class="py-2">Método</th>
                <th class="py-2 text-right">Intentos</th>
                <th class="py-2 text-right">Éxito</th>
              </tr>
            </thead>
            <tbody class="divide-y divide-slate-100">
              <tr v-for="item in data.breakdowns.byMethod" :key="item.key">
                <td class="py-2.5 font-medium text-slate-800">{{ item.label }}</td>
                <td class="py-2.5 text-right font-semibold">{{ item.attempts }}</td>
                <td class="py-2.5 text-right font-medium text-emerald-600">{{ formatPercent(item.successRate) }}</td>
              </tr>
            </tbody>
          </table>
        </div>

        <!-- Por Banco emisor -->
        <div class="rounded-xl border border-slate-200 bg-white p-5 shadow-sm space-y-3">
          <h4 class="text-sm font-bold text-slate-900 uppercase tracking-wide">Por Banco Emisor</h4>
          <table class="w-full text-left text-xs text-slate-700" data-testid="breakdown-bank-table">
            <thead class="border-b border-slate-200 text-slate-400 uppercase font-medium">
              <tr>
                <th class="py-2">Banco</th>
                <th class="py-2 text-right">Intentos</th>
                <th class="py-2 text-right">Éxito</th>
              </tr>
            </thead>
            <tbody class="divide-y divide-slate-100">
              <tr v-for="item in data.breakdowns.byBank" :key="item.key">
                <td class="py-2.5 font-medium text-slate-800">{{ item.label }}</td>
                <td class="py-2.5 text-right font-semibold">{{ item.attempts }}</td>
                <td class="py-2.5 text-right font-medium text-emerald-600">{{ formatPercent(item.successRate) }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>
  </div>
</template>

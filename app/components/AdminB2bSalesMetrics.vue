<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import type { B2bSalesMetricsResponse } from '~~/shared/b2b-sales-metrics'

const props = defineProps<{ runtime: unknown }>()
const { ready, loggedIn, user } = useUserSession()
const requestFetch = useRequestFetch()

const fromDate = ref('')
const toDate = ref('')
const loading = ref(false)
const error = ref<string | null>(null)
const data = ref<B2bSalesMetricsResponse | null>(null)

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

async function fetchMetrics() {
  if (!isAuthorized.value) return
  loading.value = true
  error.value = null

  try {
    const params = new URLSearchParams()
    if (fromDate.value) params.set('from', fromDate.value)
    if (toDate.value) params.set('to', toDate.value)

    const response = await requestFetch<B2bSalesMetricsResponse>(
      `/api/admin/b2b/metrics${params.toString() ? `?${params.toString()}` : ''}`,
      { method: 'GET' }
    )
    data.value = response
  } catch (err: unknown) {
    error.value = err instanceof Error ? err.message : 'Error al cargar métricas de venta a empresas'
  } finally {
    loading.value = false
  }
}

onMounted(() => {
  if (isAuthorized.value) {
    void fetchMetrics()
  }
})
</script>

<template>
  <div class="space-y-6">
    <!-- Header -->
    <div class="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
      <div>
        <h2 class="text-xl font-bold text-slate-900 flex items-center gap-2">
          Venta a Empresas (B2B): activación, conversión, recurrencia y condiciones comerciales
          <span class="rounded bg-emerald-100 px-2 py-0.5 text-xs font-semibold text-emerald-800">DAT-020</span>
        </h2>
        <p class="text-sm text-slate-500">
          Métricas de clientes corporativos, condiciones de pago, exposición crediticia y tarifas comerciales reales.
        </p>
      </div>

      <button
        type="button"
        class="inline-flex items-center justify-center rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-emerald-700 disabled:opacity-50"
        :disabled="loading || !isAuthorized"
        data-testid="b2b-refresh"
        @click="fetchMetrics"
      >
        <span v-if="loading">Cargando...</span>
        <span v-else>Actualizar</span>
      </button>
    </div>

    <!-- Filtros -->
    <div class="rounded-xl border border-slate-200 bg-white p-4 shadow-sm space-y-4">
      <div class="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <div>
          <label for="b2b-from-date" class="block text-xs font-medium text-slate-700">Desde</label>
          <input
            id="b2b-from-date"
            v-model="fromDate"
            type="date"
            class="mt-1 block w-full rounded-md border border-slate-300 px-3 py-1.5 text-sm shadow-sm focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500"
          />
        </div>
        <div>
          <label for="b2b-to-date" class="block text-xs font-medium text-slate-700">Hasta</label>
          <input
            id="b2b-to-date"
            v-model="toDate"
            type="date"
            class="mt-1 block w-full rounded-md border border-slate-300 px-3 py-1.5 text-sm shadow-sm focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500"
          />
        </div>
        <div class="flex items-end">
          <button
            type="button"
            class="w-full rounded-md bg-slate-100 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-200"
            @click="fetchMetrics"
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
      <!-- 1. ACTIVACIÓN -->
      <div>
        <h3 class="text-sm font-semibold text-slate-800 uppercase tracking-wide mb-3">
          1. Activación de Clientes Corporativos
        </h3>
        <div class="grid grid-cols-2 gap-4 sm:grid-cols-4">
          <div class="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
            <span class="text-xs font-medium text-slate-500">Tasa de Activación</span>
            <p class="mt-1 text-2xl font-bold text-emerald-600" data-testid="b2b-kpi-activation-rate">
              {{ formatPercent(data.activation.activationRate) }}
            </p>
            <span class="text-xs text-slate-500"
              >{{ data.activation.activatedCompanies }} de {{ data.activation.approvedCompanies }} aprobadas</span
            >
          </div>

          <div class="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
            <span class="text-xs font-medium text-slate-500">Empresas Activadas</span>
            <p class="mt-1 text-2xl font-bold text-slate-900" data-testid="b2b-kpi-activated-count">
              {{ data.activation.activatedCompanies }}
            </p>
            <span class="text-xs text-slate-500">Con al menos 1 pedido</span>
          </div>

          <div class="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
            <span class="text-xs font-medium text-slate-500">Días a Primer Pedido</span>
            <p class="mt-1 text-2xl font-bold text-slate-900" data-testid="b2b-kpi-avg-days-first-order">
              {{ data.activation.avgDaysToFirstOrder.toFixed(1) }}
            </p>
            <span class="text-xs text-slate-500">Promedio desde aprobación</span>
          </div>

          <div class="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
            <span class="text-xs font-medium text-slate-500">Pendientes de Activación</span>
            <div class="mt-1 text-xs text-slate-600 space-y-1">
              <div>
                &lt; 30 días:
                <span class="font-semibold text-slate-900">{{
                  data.activation.pendingActivationAging.under30Days
                }}</span>
              </div>
              <div>
                30 - 90 días:
                <span class="font-semibold text-amber-600">{{
                  data.activation.pendingActivationAging.days30to90
                }}</span>
              </div>
              <div>
                &gt; 90 días:
                <span class="font-semibold text-red-600">{{ data.activation.pendingActivationAging.over90Days }}</span>
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- 2. CONVERSIÓN -->
      <div>
        <h3 class="text-sm font-semibold text-slate-800 uppercase tracking-wide mb-3">
          2. Conversión y Facturación B2B
        </h3>
        <div class="grid grid-cols-2 gap-4 sm:grid-cols-3">
          <div class="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
            <span class="text-xs font-medium text-slate-500">Pedidos Corporativos</span>
            <p class="mt-1 text-2xl font-bold text-slate-900" data-testid="b2b-kpi-orders-count">
              {{ data.conversion.ordersCount }}
            </p>
            <span class="text-xs text-slate-500">{{ data.conversion.checkoutsCompleted }} checkouts finalizados</span>
          </div>

          <div class="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
            <span class="text-xs font-medium text-slate-500">Facturación Neta B2B</span>
            <p class="mt-1 text-2xl font-bold text-emerald-600" data-testid="b2b-kpi-revenue">
              {{ formatEuros(data.conversion.revenueNetCents) }}
            </p>
          </div>

          <div class="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
            <span class="text-xs font-medium text-slate-500">Ticket Medio (AOV)</span>
            <p class="mt-1 text-2xl font-bold text-slate-900" data-testid="b2b-kpi-aov">
              {{ formatEuros(data.conversion.averageOrderValueCents) }}
            </p>
          </div>
        </div>
      </div>

      <!-- 3. RECURRENCIA -->
      <div>
        <h3 class="text-sm font-semibold text-slate-800 uppercase tracking-wide mb-3">3. Recurrencia y Fidelización</h3>
        <div class="grid grid-cols-2 gap-4 sm:grid-cols-3">
          <div class="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
            <span class="text-xs font-medium text-slate-500">Tasa de Recompra B2B</span>
            <p class="mt-1 text-2xl font-bold text-indigo-600" data-testid="b2b-kpi-repeat-rate">
              {{ formatPercent(data.recurrence.repeatPurchaseRate) }}
            </p>
            <span class="text-xs text-slate-500">Compradores con 2+ pedidos</span>
          </div>

          <div class="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
            <span class="text-xs font-medium text-slate-500">Compradores Recurrentes</span>
            <p class="mt-1 text-2xl font-bold text-slate-900" data-testid="b2b-kpi-repeat-buyers">
              {{ data.recurrence.repeatBuyers }}
            </p>
            <span class="text-xs text-slate-500">{{ data.recurrence.oneTimeBuyers }} comprador(es) únicos</span>
          </div>

          <div class="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
            <span class="text-xs font-medium text-slate-500">Cadencia entre Pedidos</span>
            <p class="mt-1 text-2xl font-bold text-slate-900" data-testid="b2b-kpi-cadence">
              {{ data.recurrence.avgDaysBetweenOrders }} días
            </p>
            <span class="text-xs text-slate-500">Promedio entre recompras</span>
          </div>
        </div>
      </div>

      <!-- 4. CONDICIONES COMERCIALES REALES -->
      <div>
        <h3 class="text-sm font-semibold text-slate-800 uppercase tracking-wide mb-3">
          4. Condiciones Comerciales Reales (Riesgo y Plazos de Pago)
        </h3>
        <div class="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <!-- Plazos de Pago -->
          <div
            class="rounded-xl border border-slate-200 bg-white shadow-sm overflow-hidden"
            data-testid="b2b-payment-terms-table"
          >
            <div class="border-b border-slate-200 bg-slate-50 px-4 py-3">
              <h4 class="text-xs font-semibold text-slate-900 uppercase">Distribución de Plazos de Pago</h4>
            </div>
            <table class="min-w-full divide-y divide-slate-200 text-sm">
              <thead class="bg-slate-50 text-xs font-medium text-slate-500 uppercase">
                <tr>
                  <th class="px-4 py-2 text-left">Condición de Pago</th>
                  <th class="px-4 py-2 text-right">Empresas</th>
                </tr>
              </thead>
              <tbody class="divide-y divide-slate-200 bg-white">
                <tr v-for="t in data.commercialTerms.paymentTermsDistribution" :key="t.paymentDays">
                  <td class="px-4 py-2 font-medium text-slate-800">
                    {{ t.paymentDays === 0 ? 'Contado / Prepago' : `${t.paymentDays} días` }}
                  </td>
                  <td class="px-4 py-2 text-right text-slate-600">{{ t.companiesCount }}</td>
                </tr>
              </tbody>
            </table>
          </div>

          <!-- Líneas de Crédito & Tarifas -->
          <div class="rounded-xl border border-slate-200 bg-white p-4 shadow-sm space-y-4">
            <h4 class="text-xs font-semibold text-slate-900 uppercase">Exposición Crediticia</h4>
            <div class="grid grid-cols-2 gap-4">
              <div>
                <span class="text-xs font-medium text-slate-500">Límite de Crédito Concedido</span>
                <p class="mt-1 text-xl font-bold text-slate-900" data-testid="b2b-kpi-credit-limit">
                  {{ formatEuros(data.commercialTerms.creditExposure.totalCreditLimitCents) }}
                </p>
              </div>
              <div>
                <span class="text-xs font-medium text-slate-500">Cuentas Bloqueadas por Riesgo</span>
                <p class="mt-1 text-xl font-bold text-red-600" data-testid="b2b-kpi-blocked-companies">
                  {{ data.commercialTerms.creditExposure.blockedCompaniesCount }}
                </p>
              </div>
            </div>

            <div class="border-t border-slate-200 pt-3">
              <h5 class="text-xs font-semibold text-slate-700 uppercase mb-2">Tarifas Contractuales Asignadas</h5>
              <div class="space-y-1 text-xs">
                <div
                  v-for="tier in data.commercialTerms.pricingTiersDistribution"
                  :key="tier.priceListId"
                  class="flex justify-between text-slate-600"
                >
                  <span class="font-mono text-slate-900">{{ tier.priceListId }}</span>
                  <span>{{ tier.companiesCount }} empresas asignadas</span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- Top Empresas -->
      <div
        v-if="data.topCompanies.length > 0"
        class="rounded-xl border border-slate-200 bg-white shadow-sm overflow-hidden"
      >
        <div class="border-b border-slate-200 bg-slate-50 px-4 py-3">
          <h3 class="text-sm font-semibold text-slate-900">Ranking de Clientes Corporativos por Facturación</h3>
        </div>
        <table class="min-w-full divide-y divide-slate-200 text-sm">
          <thead class="bg-slate-50 text-xs font-medium text-slate-500 uppercase text-left">
            <tr>
              <th class="px-4 py-3">Empresa</th>
              <th class="px-4 py-3 text-right">Pedidos</th>
              <th class="px-4 py-3 text-right">Facturación Neta</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-slate-200 bg-white">
            <tr v-for="comp in data.topCompanies" :key="comp.companyId" class="hover:bg-slate-50">
              <td class="px-4 py-3 font-semibold text-slate-900">{{ comp.legalName }}</td>
              <td class="px-4 py-3 text-right text-slate-600">{{ comp.ordersCount }}</td>
              <td class="px-4 py-3 text-right font-semibold text-emerald-600">
                {{ formatEuros(comp.revenueNetCents) }}
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  </div>
</template>

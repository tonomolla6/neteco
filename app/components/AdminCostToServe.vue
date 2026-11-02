<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import type { CostToServeDashboardResponse } from '~~/shared/cost-to-serve'

const props = defineProps<{ runtime: unknown }>()
const { ready, loggedIn, user } = useUserSession()
const requestFetch = useRequestFetch()

const fromDate = ref('')
const toDate = ref('')
const selectedTier = ref<string>('all')

const loading = ref(false)
const error = ref<string | null>(null)
const data = ref<CostToServeDashboardResponse | null>(null)

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

function tierBadgeClass(tier: string): string {
  switch (tier) {
    case 'high_margin':
      return 'bg-emerald-100 text-emerald-800'
    case 'healthy_margin':
      return 'bg-blue-100 text-blue-800'
    case 'low_margin':
      return 'bg-amber-100 text-amber-800'
    case 'loss_making':
      return 'bg-red-100 text-red-800 font-semibold'
    default:
      return 'bg-slate-100 text-slate-800'
  }
}

function tierLabel(tier: string): string {
  switch (tier) {
    case 'high_margin':
      return 'Margen Alto (>30%)'
    case 'healthy_margin':
      return 'Margen Saludable (10-30%)'
    case 'low_margin':
      return 'Margen Bajo (0-10%)'
    case 'loss_making':
      return 'En Pérdidas (<0%)'
    default:
      return tier
  }
}

async function fetchCostToServe() {
  if (!isAuthorized.value) return
  loading.value = true
  error.value = null

  try {
    const params = new URLSearchParams()
    if (fromDate.value) params.set('from', fromDate.value)
    if (toDate.value) params.set('to', toDate.value)
    if (selectedTier.value && selectedTier.value !== 'all') params.set('profitabilityTier', selectedTier.value)

    const response = await requestFetch<CostToServeDashboardResponse>(
      `/api/admin/analytics/cost-to-serve/orders${params.toString() ? `?${params.toString()}` : ''}`,
      { method: 'GET' }
    )
    data.value = response
  } catch (err: unknown) {
    error.value = err instanceof Error ? err.message : 'Error al cargar métricas de Cost-to-Serve'
  } finally {
    loading.value = false
  }
}

onMounted(() => {
  if (isAuthorized.value) {
    void fetchCostToServe()
  }
})
</script>

<template>
  <div class="space-y-6">
    <!-- Header -->
    <div class="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
      <div>
        <h2 class="text-xl font-bold text-slate-900 flex items-center gap-2">
          Cost-to-Serve y Margen de Contribución
          <span class="rounded bg-emerald-100 px-2 py-0.5 text-xs font-semibold text-emerald-800">DAT-021</span>
        </h2>
        <p class="text-sm text-slate-500">
          COGS, descuentos, comisiones de pago, picking, porte real de transporte, devoluciones y soporte vinculados a
          cada pedido.
        </p>
      </div>

      <button
        type="button"
        class="inline-flex items-center justify-center rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-emerald-700 disabled:opacity-50"
        :disabled="loading || !isAuthorized"
        data-testid="cts-refresh"
        @click="fetchCostToServe"
      >
        <span v-if="loading">Cargando...</span>
        <span v-else>Actualizar</span>
      </button>
    </div>

    <!-- Filtros -->
    <div class="rounded-xl border border-slate-200 bg-white p-4 shadow-sm space-y-4">
      <div class="grid grid-cols-1 gap-4 sm:grid-cols-4">
        <div>
          <label for="cts-from-date" class="block text-xs font-medium text-slate-700">Desde</label>
          <input
            id="cts-from-date"
            v-model="fromDate"
            type="date"
            class="mt-1 block w-full rounded-md border border-slate-300 px-3 py-1.5 text-sm shadow-sm focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500"
          />
        </div>
        <div>
          <label for="cts-to-date" class="block text-xs font-medium text-slate-700">Hasta</label>
          <input
            id="cts-to-date"
            v-model="toDate"
            type="date"
            class="mt-1 block w-full rounded-md border border-slate-300 px-3 py-1.5 text-sm shadow-sm focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500"
          />
        </div>
        <div>
          <label for="cts-tier-filter" class="block text-xs font-medium text-slate-700">Rentabilidad</label>
          <select
            id="cts-tier-filter"
            v-model="selectedTier"
            class="mt-1 block w-full rounded-md border border-slate-300 px-3 py-1.5 text-sm shadow-sm focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500"
          >
            <option value="all">Todos los tramos</option>
            <option value="high_margin">Margen Alto (&gt;30%)</option>
            <option value="healthy_margin">Margen Saludable (10-30%)</option>
            <option value="low_margin">Margen Bajo (0-10%)</option>
            <option value="loss_making">En Pérdidas (&lt;0%)</option>
          </select>
        </div>
        <div class="flex items-end">
          <button
            type="button"
            class="w-full rounded-md bg-slate-100 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-200"
            @click="fetchCostToServe"
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
      <!-- Summary Cards -->
      <div class="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5">
        <div class="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
          <span class="text-xs font-medium text-slate-500">Facturación Neta</span>
          <p class="mt-1 text-2xl font-bold text-slate-900" data-testid="cts-kpi-net-revenue">
            {{ formatEuros(data.summary.totalNetRevenueCents) }}
          </p>
          <span class="text-xs text-slate-500">{{ data.summary.totalOrdersAnalyzed }} pedidos analizados</span>
        </div>

        <div class="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
          <span class="text-xs font-medium text-slate-500">Cost-to-Serve Total</span>
          <p class="mt-1 text-2xl font-bold text-slate-900" data-testid="cts-kpi-cost-to-serve">
            {{ formatEuros(data.summary.totalCostToServeCents) }}
          </p>
          <span class="text-xs text-slate-500">Costes directos totales</span>
        </div>

        <div class="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
          <span class="text-xs font-medium text-slate-500">Margen de Contribución</span>
          <p
            :class="[
              'mt-1 text-2xl font-bold',
              data.summary.totalContributionMarginCents >= 0 ? 'text-emerald-600' : 'text-red-600'
            ]"
            data-testid="cts-kpi-contribution-margin"
          >
            {{ formatEuros(data.summary.totalContributionMarginCents) }}
          </p>
        </div>

        <div class="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
          <span class="text-xs font-medium text-slate-500">Ratio de Margen Global</span>
          <p class="mt-1 text-2xl font-bold text-indigo-600" data-testid="cts-kpi-margin-ratio">
            {{ formatPercent(data.summary.overallMarginRatio) }}
          </p>
          <span class="text-xs text-slate-500">Margen / Facturación Neta</span>
        </div>

        <div class="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
          <span class="text-xs font-medium text-slate-500">Pedidos en Pérdidas</span>
          <p class="mt-1 text-2xl font-bold text-red-600" data-testid="cts-kpi-loss-making-rate">
            {{ formatPercent(data.summary.lossMakingRate) }}
          </p>
          <span class="text-xs text-slate-500"
            >{{ data.summary.lossMakingOrdersCount }} de {{ data.summary.totalOrdersAnalyzed }} pedidos</span
          >
        </div>
      </div>

      <!-- 7 Factores de Coste Breakdown -->
      <div class="rounded-xl border border-slate-200 bg-white p-4 shadow-sm space-y-4">
        <h3 class="text-sm font-semibold text-slate-900 uppercase tracking-wide">
          Desglose de los 7 Factores de Cost-to-Serve Vinculados al Pedido
        </h3>

        <div class="grid grid-cols-2 gap-4 sm:grid-cols-4 lg:grid-cols-7">
          <div class="rounded-lg bg-slate-50 p-3 border border-slate-200">
            <span class="text-xs font-medium text-slate-500">1. COGS (Producto)</span>
            <p class="mt-1 text-lg font-bold text-slate-800" data-testid="factor-cogs">
              {{ formatEuros(data.summary.totalCogsCents) }}
            </p>
          </div>

          <div class="rounded-lg bg-slate-50 p-3 border border-slate-200">
            <span class="text-xs font-medium text-slate-500">2. Descuentos</span>
            <p class="mt-1 text-lg font-bold text-slate-800" data-testid="factor-discounts">
              {{ formatEuros(data.summary.totalDiscountCents) }}
            </p>
          </div>

          <div class="rounded-lg bg-slate-50 p-3 border border-slate-200">
            <span class="text-xs font-medium text-slate-500">3. Comisiones Pago</span>
            <p class="mt-1 text-lg font-bold text-slate-800" data-testid="factor-payment">
              {{ formatEuros(data.summary.totalPaymentFeeCents) }}
            </p>
          </div>

          <div class="rounded-lg bg-slate-50 p-3 border border-slate-200">
            <span class="text-xs font-medium text-slate-500">4. Picking / Envase</span>
            <p class="mt-1 text-lg font-bold text-slate-800" data-testid="factor-picking">
              {{ formatEuros(data.summary.totalPickingCostCents) }}
            </p>
          </div>

          <div class="rounded-lg bg-slate-50 p-3 border border-slate-200">
            <span class="text-xs font-medium text-slate-500">5. Porte Real Transporte</span>
            <p class="mt-1 text-lg font-bold text-slate-800" data-testid="factor-carrier">
              {{ formatEuros(data.summary.totalShippingRealCostCents) }}
            </p>
          </div>

          <div class="rounded-lg bg-slate-50 p-3 border border-slate-200">
            <span class="text-xs font-medium text-slate-500">6. Devoluciones</span>
            <p class="mt-1 text-lg font-bold text-slate-800" data-testid="factor-returns">
              {{ formatEuros(data.summary.totalReturnsCostCents) }}
            </p>
          </div>

          <div class="rounded-lg bg-slate-50 p-3 border border-slate-200">
            <span class="text-xs font-medium text-slate-500">7. Soporte al Cliente</span>
            <p class="mt-1 text-lg font-bold text-slate-800" data-testid="factor-support">
              {{ formatEuros(data.summary.totalSupportCostCents) }}
            </p>
          </div>
        </div>
      </div>

      <!-- Orders Breakdown Table -->
      <div class="rounded-xl border border-slate-200 bg-white shadow-sm overflow-hidden" data-testid="cts-orders-table">
        <div class="border-b border-slate-200 bg-slate-50 px-4 py-3">
          <h3 class="text-sm font-semibold text-slate-900">Detalle de Margen de Contribución por Pedido</h3>
        </div>
        <div class="overflow-x-auto">
          <table class="min-w-full divide-y divide-slate-200 text-xs">
            <thead class="bg-slate-50 font-medium text-slate-500 uppercase text-left">
              <tr>
                <th class="px-3 py-2.5">ID Pedido</th>
                <th class="px-3 py-2.5 text-right">Fact. Neta</th>
                <th class="px-3 py-2.5 text-right">COGS</th>
                <th class="px-3 py-2.5 text-right">Pago</th>
                <th class="px-3 py-2.5 text-right">Picking</th>
                <th class="px-3 py-2.5 text-right">Porte Real</th>
                <th class="px-3 py-2.5 text-right">Devoluciones</th>
                <th class="px-3 py-2.5 text-right">Soporte</th>
                <th class="px-3 py-2.5 text-right">Cost-to-Serve</th>
                <th class="px-3 py-2.5 text-right font-bold">Margen Contribución</th>
                <th class="px-3 py-2.5 text-center">Tramo</th>
              </tr>
            </thead>
            <tbody class="divide-y divide-slate-200 bg-white">
              <tr v-for="order in data.orders" :key="order.id" class="hover:bg-slate-50 font-mono">
                <td class="px-3 py-2.5 text-slate-900 font-semibold">{{ order.orderId }}</td>
                <td class="px-3 py-2.5 text-right text-slate-900 font-medium">
                  {{ formatEuros(order.netRevenueCents) }}
                </td>
                <td class="px-3 py-2.5 text-right text-slate-600">{{ formatEuros(order.cogsCents) }}</td>
                <td class="px-3 py-2.5 text-right text-slate-600">{{ formatEuros(order.paymentFeeCents) }}</td>
                <td class="px-3 py-2.5 text-right text-slate-600">{{ formatEuros(order.pickingCostCents) }}</td>
                <td class="px-3 py-2.5 text-right text-slate-600">{{ formatEuros(order.shippingRealCostCents) }}</td>
                <td class="px-3 py-2.5 text-right text-slate-600">{{ formatEuros(order.returnsCostCents) }}</td>
                <td class="px-3 py-2.5 text-right text-slate-600">{{ formatEuros(order.supportCostCents) }}</td>
                <td class="px-3 py-2.5 text-right font-semibold text-slate-800">
                  {{ formatEuros(order.totalCostToServeCents) }}
                </td>
                <td
                  :class="[
                    'px-3 py-2.5 text-right font-bold',
                    order.contributionMarginCents >= 0 ? 'text-emerald-600' : 'text-red-600'
                  ]"
                >
                  {{ formatEuros(order.contributionMarginCents) }} ({{ formatPercent(order.marginRatio) }})
                </td>
                <td class="px-3 py-2.5 text-center">
                  <span
                    :class="[
                      'px-2 py-0.5 rounded text-[10px] font-sans font-semibold',
                      tierBadgeClass(order.profitabilityTier)
                    ]"
                  >
                    {{ tierLabel(order.profitabilityTier) }}
                  </span>
                </td>
              </tr>
              <tr v-if="data.orders.length === 0">
                <td colspan="11" class="px-4 py-8 text-center text-slate-500 font-sans">
                  No hay pedidos calculados en este período.
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
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

const tierTones: Record<string, 'success' | 'info' | 'warning' | 'danger'> = {
  high_margin: 'success',
  healthy_margin: 'info',
  low_margin: 'warning',
  loss_making: 'danger'
}
const tierLabels: Record<string, string> = {
  high_margin: 'Margen alto',
  healthy_margin: 'Margen correcto',
  low_margin: 'Margen bajo',
  loss_making: 'En pérdidas'
}
function tierLabel(tier: string): string {
  return tierLabels[tier] ?? adminHumanize(tier)
}

const preset = ref('')
const presetOptions = [
  { value: '7', label: '7 días' },
  { value: '30', label: '30 días' },
  { value: '90', label: '90 días' }
]
watch(preset, (value) => {
  if (!value) return
  const end = new Date()
  fromDate.value = new Date(end.getTime() - Number(value) * 86_400_000).toISOString().slice(0, 10)
  toDate.value = end.toISOString().slice(0, 10)
  void fetchCostToServe()
})
function onDateChange() {
  preset.value = ''
  void fetchCostToServe()
}
type OrderRow = CostToServeDashboardResponse['orders'][number]
const columns = [
  { key: 'orderId', label: 'Pedido' },
  { key: 'netRevenueCents', label: 'Venta neta', numeric: true, sortable: true },
  { key: 'cogsCents', label: 'Producto', numeric: true, sortable: true, hideOnMobile: true },
  { key: 'paymentFeeCents', label: 'Cobro', numeric: true, sortable: true, hideOnMobile: true },
  { key: 'pickingCostCents', label: 'Preparación', numeric: true, sortable: true, hideOnMobile: true },
  { key: 'shippingRealCostCents', label: 'Transporte', numeric: true, sortable: true, hideOnMobile: true },
  { key: 'returnsCostCents', label: 'Devoluciones', numeric: true, sortable: true, hideOnMobile: true },
  { key: 'supportCostCents', label: 'Atención', numeric: true, sortable: true, hideOnMobile: true },
  { key: 'totalCostToServeCents', label: 'Coste total', numeric: true, sortable: true },
  { key: 'contributionMarginCents', label: 'Margen', numeric: true, sortable: true },
  { key: 'profitabilityTier', label: 'Rentabilidad' }
]
const factors = computed(() => {
  const summary = data.value?.summary
  if (!summary) return []
  const list = [
    { id: 'cogs', label: 'Coste del producto', value: summary.totalCogsCents },
    { id: 'discounts', label: 'Descuentos', value: summary.totalDiscountCents },
    { id: 'payment', label: 'Comisiones de cobro', value: summary.totalPaymentFeeCents },
    { id: 'picking', label: 'Preparación y embalaje', value: summary.totalPickingCostCents },
    { id: 'carrier', label: 'Transporte', value: summary.totalShippingRealCostCents },
    { id: 'returns', label: 'Devoluciones', value: summary.totalReturnsCostCents },
    { id: 'support', label: 'Atención al cliente', value: summary.totalSupportCostCents }
  ]
  const max = Math.max(1, ...list.map((item) => item.value ?? 0))
  return list.map((item) => ({ ...item, share: Math.max(0, (item.value ?? 0) / max) * 100 }))
})
const orderRef = (id: string) => (id.length > 12 ? `#${id.slice(0, 8).toUpperCase()}` : id)

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
  <div class="adm-stack">
    <AdminCard v-if="!isAuthorized">
      <AdminEmptyState
        icon="i-lucide-lock"
        title="La rentabilidad no está disponible ahora"
        description="Necesitas la sesión iniciada, el correo verificado y la verificación en dos pasos, y solo se puede consultar en la tienda publicada."
      />
    </AdminCard>
    <template v-else>
      <div class="adm-toolbar" role="search" aria-label="Filtros de rentabilidad">
        <AdminFilters v-model="preset" :options="presetOptions" label="Periodo" />
        <label for="cts-from-date" class="adm-help">Desde</label>
        <input id="cts-from-date" v-model="fromDate" type="date" class="adm-input w-auto" @change="onDateChange" />
        <label for="cts-to-date" class="adm-help">Hasta</label>
        <input id="cts-to-date" v-model="toDate" type="date" class="adm-input w-auto" @change="onDateChange" />
        <label for="cts-tier-filter" class="sr-only">Rentabilidad</label>
        <select id="cts-tier-filter" v-model="selectedTier" class="adm-input w-auto" @change="fetchCostToServe">
          <option value="all">Cualquier rentabilidad</option>
          <option value="high_margin">Margen alto (más del 30 %)</option>
          <option value="healthy_margin">Margen correcto (10-30 %)</option>
          <option value="low_margin">Margen bajo (0-10 %)</option>
          <option value="loss_making">En pérdidas</option>
        </select>
        <div class="adm-toolbar__end">
          <button
            type="button"
            class="adm-btn adm-btn--secondary"
            :disabled="loading"
            data-testid="cts-refresh"
            @click="fetchCostToServe"
          >
            <UIcon name="i-lucide-rotate-cw" class="size-4" :class="loading && 'animate-spin'" />Actualizar
          </button>
        </div>
      </div>

      <AdminCard v-if="error">
        <AdminEmptyState
          variant="error"
          title="No hemos podido calcular la rentabilidad"
          description="Vuelve a intentarlo en unos segundos."
        >
          <AdminButton icon="i-lucide-rotate-cw" @click="fetchCostToServe">Reintentar</AdminButton>
        </AdminEmptyState>
      </AdminCard>

      <div v-else-if="loading && !data" class="adm-grid" aria-busy="true">
        <span class="sr-only">Calculando la rentabilidad…</span>
        <div
          v-for="row in 5"
          :key="row"
          class="h-28 animate-pulse rounded-[var(--radius-surface)] bg-[var(--surface-sunken)]"
        />
      </div>

      <template v-if="data">
        <div class="adm-grid">
          <div class="adm-card adm-stat">
            <p class="adm-stat__label"><UIcon name="i-lucide-receipt-text" class="size-4" />Ventas netas</p>
            <p class="adm-stat__value" data-testid="cts-kpi-net-revenue">
              {{ formatEuros(data.summary.totalNetRevenueCents) }}
            </p>
            <p class="adm-stat__foot">{{ data.summary.totalOrdersAnalyzed }} pedidos analizados</p>
          </div>
          <div class="adm-card adm-stat">
            <p class="adm-stat__label"><UIcon name="i-lucide-coins" class="size-4" />Coste de servir los pedidos</p>
            <p class="adm-stat__value" data-testid="cts-kpi-cost-to-serve">
              {{ formatEuros(data.summary.totalCostToServeCents) }}
            </p>
            <p class="adm-stat__foot">Producto, cobro, preparación, transporte…</p>
          </div>
          <div class="adm-card adm-stat">
            <p class="adm-stat__label"><UIcon name="i-lucide-piggy-bank" class="size-4" />Margen</p>
            <p class="adm-stat__value" data-testid="cts-kpi-contribution-margin">
              {{ formatEuros(data.summary.totalContributionMarginCents) }}
            </p>
            <p class="adm-stat__foot">
              {{ data.summary.totalContributionMarginCents >= 0 ? 'Lo que queda tras los costes' : 'Se pierde dinero' }}
            </p>
          </div>
          <div class="adm-card adm-stat">
            <p class="adm-stat__label"><UIcon name="i-lucide-percent" class="size-4" />Margen sobre ventas</p>
            <p class="adm-stat__value" data-testid="cts-kpi-margin-ratio">
              {{ formatPercent(data.summary.overallMarginRatio) }}
            </p>
            <p class="adm-stat__foot">Margen dividido entre ventas netas</p>
          </div>
          <div class="adm-card adm-stat">
            <p class="adm-stat__label"><UIcon name="i-lucide-trending-down" class="size-4" />Pedidos en pérdidas</p>
            <p class="adm-stat__value" data-testid="cts-kpi-loss-making-rate">
              {{ formatPercent(data.summary.lossMakingRate) }}
            </p>
            <p class="adm-stat__foot">
              {{ data.summary.lossMakingOrdersCount }} de {{ data.summary.totalOrdersAnalyzed }} pedidos
            </p>
          </div>
        </div>

        <AdminCard title="En qué se va el dinero" description="Costes de todos los pedidos del periodo.">
          <ul class="adm-breakdown">
            <li v-for="factor in factors" :key="factor.id">
              <div class="adm-breakdown__row">
                <span class="adm-breakdown__label">{{ factor.label }}</span>
                <span class="adm-breakdown__value" :data-testid="`factor-${factor.id}`">
                  {{ formatEuros(factor.value) }}
                </span>
                <span class="adm-breakdown__track"><i :style="{ width: `${factor.share}%` }" /></span>
              </div>
            </li>
          </ul>
        </AdminCard>

        <AdminSection title="Rentabilidad por pedido">
          <AdminTable
            data-testid="cts-orders-table"
            :rows="data.orders"
            :columns="columns"
            :row-key="(row: OrderRow) => row.id"
            :status="loading ? 'pending' : 'idle'"
            empty-title="Sin pedidos en este periodo"
            empty-description="No hay pedidos calculados con estos filtros."
            empty-icon="i-lucide-receipt-text"
            caption="Costes y margen de cada pedido"
          >
            <template #cell-orderId="{ row }">
              <span class="font-semibold text-[var(--text-strong)]">{{ orderRef(row.orderId) }}</span>
            </template>
            <template #cell-netRevenueCents="{ row }">{{ formatEuros(row.netRevenueCents) }}</template>
            <template #cell-cogsCents="{ row }">{{ formatEuros(row.cogsCents) }}</template>
            <template #cell-paymentFeeCents="{ row }">{{ formatEuros(row.paymentFeeCents) }}</template>
            <template #cell-pickingCostCents="{ row }">{{ formatEuros(row.pickingCostCents) }}</template>
            <template #cell-shippingRealCostCents="{ row }">{{ formatEuros(row.shippingRealCostCents) }}</template>
            <template #cell-returnsCostCents="{ row }">{{ formatEuros(row.returnsCostCents) }}</template>
            <template #cell-supportCostCents="{ row }">{{ formatEuros(row.supportCostCents) }}</template>
            <template #cell-totalCostToServeCents="{ row }">{{ formatEuros(row.totalCostToServeCents) }}</template>
            <template #cell-contributionMarginCents="{ row }">
              <span class="font-semibold" :class="row.contributionMarginCents < 0 && 'text-red-700'">
                {{ formatEuros(row.contributionMarginCents) }}
              </span>
              <span class="adm-help ml-1">({{ formatPercent(row.marginRatio) }})</span>
            </template>
            <template #cell-profitabilityTier="{ row }">
              <AdminBadge :tone="tierTones[row.profitabilityTier] ?? 'neutral'">
                {{ tierLabel(row.profitabilityTier) }}
              </AdminBadge>
            </template>
          </AdminTable>
        </AdminSection>
      </template>
    </template>
  </div>
</template>

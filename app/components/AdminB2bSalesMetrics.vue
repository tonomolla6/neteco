<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
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

const preset = ref('')
const presetOptions = [
  { value: '30', label: '30 días' },
  { value: '90', label: '90 días' },
  { value: '365', label: '12 meses' }
]
watch(preset, (value) => {
  if (!value) return
  const end = new Date()
  fromDate.value = new Date(end.getTime() - Number(value) * 86_400_000).toISOString().slice(0, 10)
  toDate.value = end.toISOString().slice(0, 10)
  void fetchMetrics()
})
function onDateChange() {
  preset.value = ''
  void fetchMetrics()
}
const priceListRef = (id: string) => (id.length > 12 ? `Tarifa #${id.slice(0, 8).toUpperCase()}` : adminHumanize(id))

onMounted(() => {
  if (isAuthorized.value) {
    void fetchMetrics()
  }
})
</script>

<template>
  <div class="adm-stack">
    <AdminCard v-if="!isAuthorized">
      <AdminEmptyState
        icon="i-lucide-lock"
        title="Las ventas a empresas no están disponibles ahora"
        description="Necesitas la sesión iniciada, el correo verificado y la verificación en dos pasos, y solo se pueden consultar en la tienda publicada."
      />
    </AdminCard>
    <template v-else>
      <div class="adm-toolbar" role="search" aria-label="Periodo de las ventas a empresas">
        <AdminFilters v-model="preset" :options="presetOptions" label="Periodo" />
        <label for="b2b-from-date" class="adm-help">Desde</label>
        <input id="b2b-from-date" v-model="fromDate" type="date" class="adm-input w-auto" @change="onDateChange" />
        <label for="b2b-to-date" class="adm-help">Hasta</label>
        <input id="b2b-to-date" v-model="toDate" type="date" class="adm-input w-auto" @change="onDateChange" />
        <div class="adm-toolbar__end">
          <button
            type="button"
            class="adm-btn adm-btn--secondary"
            :disabled="loading"
            data-testid="b2b-refresh"
            @click="fetchMetrics"
          >
            <UIcon name="i-lucide-rotate-cw" class="size-4" :class="loading && 'animate-spin'" />Actualizar
          </button>
        </div>
      </div>

      <AdminCard v-if="error">
        <AdminEmptyState
          variant="error"
          title="No hemos podido cargar las ventas a empresas"
          description="Vuelve a intentarlo en unos segundos."
        >
          <AdminButton icon="i-lucide-rotate-cw" @click="fetchMetrics">Reintentar</AdminButton>
        </AdminEmptyState>
      </AdminCard>

      <div v-else-if="loading && !data" class="adm-grid" aria-busy="true">
        <span class="sr-only">Cargando las ventas a empresas…</span>
        <div
          v-for="row in 4"
          :key="row"
          class="h-28 animate-pulse rounded-[var(--radius-surface)] bg-[var(--surface-sunken)]"
        />
      </div>

      <template v-if="data">
        <AdminSection title="Ventas a empresas">
          <div class="adm-grid">
            <div class="adm-card adm-stat">
              <p class="adm-stat__label"><UIcon name="i-lucide-banknote" class="size-4" />Ventas netas</p>
              <p class="adm-stat__value" data-testid="b2b-kpi-revenue">
                {{ formatEuros(data.conversion.revenueNetCents) }}
              </p>
              <p class="adm-stat__foot">Sin impuestos</p>
            </div>
            <div class="adm-card adm-stat">
              <p class="adm-stat__label"><UIcon name="i-lucide-receipt-text" class="size-4" />Pedidos de empresas</p>
              <p class="adm-stat__value" data-testid="b2b-kpi-orders-count">{{ data.conversion.ordersCount }}</p>
              <p class="adm-stat__foot">{{ data.conversion.checkoutsCompleted }} compras finalizadas</p>
            </div>
            <div class="adm-card adm-stat">
              <p class="adm-stat__label"><UIcon name="i-lucide-shopping-basket" class="size-4" />Pedido medio</p>
              <p class="adm-stat__value" data-testid="b2b-kpi-aov">
                {{ formatEuros(data.conversion.averageOrderValueCents) }}
              </p>
              <p class="adm-stat__foot">Importe medio por pedido</p>
            </div>
          </div>
        </AdminSection>

        <AdminSection title="Empresas nuevas" description="Empresas aprobadas que ya han hecho su primer pedido.">
          <div class="adm-grid">
            <div class="adm-card adm-stat">
              <p class="adm-stat__label"><UIcon name="i-lucide-building-2" class="size-4" />Ya han comprado</p>
              <p class="adm-stat__value" data-testid="b2b-kpi-activation-rate">
                {{ formatPercent(data.activation.activationRate) }}
              </p>
              <p class="adm-stat__foot">
                {{ data.activation.activatedCompanies }} de {{ data.activation.approvedCompanies }} aprobadas
              </p>
            </div>
            <div class="adm-card adm-stat">
              <p class="adm-stat__label"><UIcon name="i-lucide-circle-check" class="size-4" />Empresas con pedidos</p>
              <p class="adm-stat__value" data-testid="b2b-kpi-activated-count">
                {{ data.activation.activatedCompanies }}
              </p>
              <p class="adm-stat__foot">Con al menos un pedido</p>
            </div>
            <div class="adm-card adm-stat">
              <p class="adm-stat__label">
                <UIcon name="i-lucide-calendar-clock" class="size-4" />Días hasta el primer pedido
              </p>
              <p class="adm-stat__value" data-testid="b2b-kpi-avg-days-first-order">
                {{ data.activation.avgDaysToFirstOrder.toFixed(1) }}
              </p>
              <p class="adm-stat__foot">De media desde la aprobación</p>
            </div>
            <AdminCard title="Aún sin primer pedido">
              <AdminBreakdown
                :items="[
                  { label: 'Menos de 30 días', value: data.activation.pendingActivationAging.under30Days },
                  { label: 'Entre 30 y 90 días', value: data.activation.pendingActivationAging.days30to90 },
                  { label: 'Más de 90 días', value: data.activation.pendingActivationAging.over90Days }
                ]"
              />
            </AdminCard>
          </div>
        </AdminSection>

        <AdminSection title="Empresas que repiten">
          <div class="adm-grid">
            <div class="adm-card adm-stat">
              <p class="adm-stat__label"><UIcon name="i-lucide-repeat" class="size-4" />Vuelven a comprar</p>
              <p class="adm-stat__value" data-testid="b2b-kpi-repeat-rate">
                {{ formatPercent(data.recurrence.repeatPurchaseRate) }}
              </p>
              <p class="adm-stat__foot">Empresas con dos o más pedidos</p>
            </div>
            <div class="adm-card adm-stat">
              <p class="adm-stat__label"><UIcon name="i-lucide-users" class="size-4" />Empresas habituales</p>
              <p class="adm-stat__value" data-testid="b2b-kpi-repeat-buyers">{{ data.recurrence.repeatBuyers }}</p>
              <p class="adm-stat__foot">{{ data.recurrence.oneTimeBuyers }} con un solo pedido</p>
            </div>
            <div class="adm-card adm-stat">
              <p class="adm-stat__label"><UIcon name="i-lucide-timer" class="size-4" />Tiempo entre pedidos</p>
              <p class="adm-stat__value" data-testid="b2b-kpi-cadence">
                {{ data.recurrence.avgDaysBetweenOrders }} días
              </p>
              <p class="adm-stat__foot">De media entre un pedido y el siguiente</p>
            </div>
          </div>
        </AdminSection>

        <AdminSection title="Condiciones de pago y crédito">
          <div class="grid gap-5 lg:grid-cols-2">
            <AdminCard flush title="Plazos de pago" data-testid="b2b-payment-terms-table">
              <AdminEmptyState
                v-if="!data.commercialTerms.paymentTermsDistribution.length"
                compact
                title="Sin plazos de pago asignados"
              />
              <div v-else class="adm-table-wrap">
                <table class="adm-table">
                  <thead>
                    <tr>
                      <th scope="col">Plazo</th>
                      <th scope="col" data-numeric>Empresas</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr v-for="t in data.commercialTerms.paymentTermsDistribution" :key="t.paymentDays">
                      <td>{{ t.paymentDays === 0 ? 'Al contado' : `A ${t.paymentDays} días` }}</td>
                      <td data-numeric>{{ t.companiesCount }}</td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </AdminCard>

            <AdminCard title="Crédito concedido">
              <dl class="grid grid-cols-2 gap-4">
                <div>
                  <dt class="adm-help">Límite de crédito total</dt>
                  <dd
                    class="text-lg font-semibold tabular-nums text-[var(--text-strong)]"
                    data-testid="b2b-kpi-credit-limit"
                  >
                    {{ formatEuros(data.commercialTerms.creditExposure.totalCreditLimitCents) }}
                  </dd>
                </div>
                <div>
                  <dt class="adm-help">Empresas bloqueadas por impago</dt>
                  <dd
                    class="text-lg font-semibold tabular-nums text-[var(--text-strong)]"
                    data-testid="b2b-kpi-blocked-companies"
                  >
                    {{ data.commercialTerms.creditExposure.blockedCompaniesCount }}
                  </dd>
                </div>
              </dl>
              <template v-if="data.commercialTerms.pricingTiersDistribution.length">
                <p class="adm-label mt-5">Tarifas asignadas</p>
                <ul class="mt-2 space-y-1.5">
                  <li
                    v-for="tier in data.commercialTerms.pricingTiersDistribution"
                    :key="tier.priceListId"
                    class="flex justify-between gap-3"
                  >
                    <span class="text-[var(--text-strong)]" :title="tier.priceListId">
                      {{ priceListRef(tier.priceListId) }}
                    </span>
                    <span class="adm-help">{{ tier.companiesCount }} empresas</span>
                  </li>
                </ul>
              </template>
            </AdminCard>
          </div>
        </AdminSection>

        <AdminCard v-if="data.topCompanies.length > 0" flush title="Empresas que más compran">
          <div class="adm-table-wrap">
            <table class="adm-table">
              <thead>
                <tr>
                  <th scope="col">Empresa</th>
                  <th scope="col" data-numeric>Pedidos</th>
                  <th scope="col" data-numeric>Ventas netas</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="comp in data.topCompanies" :key="comp.companyId">
                  <td class="font-semibold text-[var(--text-strong)]">{{ comp.legalName }}</td>
                  <td data-numeric>{{ comp.ordersCount }}</td>
                  <td data-numeric class="font-semibold">{{ formatEuros(comp.revenueNetCents) }}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </AdminCard>
      </template>
    </template>
  </div>
</template>

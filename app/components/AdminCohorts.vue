<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
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

const preset = ref('')
const presetOptions = [
  { value: '90', label: '3 meses' },
  { value: '180', label: '6 meses' },
  { value: '365', label: '12 meses' }
]
watch(preset, (value) => {
  if (!value) return
  const end = new Date()
  fromDate.value = new Date(end.getTime() - Number(value) * 86_400_000).toISOString().slice(0, 10)
  toDate.value = end.toISOString().slice(0, 10)
  void fetchCohorts()
})
function onDateChange() {
  preset.value = ''
  void fetchCohorts()
}
const definitionLabels: Record<string, string> = {
  cohort: 'Mes de la primera compra',
  validOrders: 'Pedidos que cuentan',
  customerIdentifier: 'Cómo se identifica a cada cliente',
  retentionWindows: 'Repiten en 30, 60, 90 o 180 días',
  medianDaysToRepurchase: 'Tiempo hasta repetir',
  churn: 'Cliente perdido',
  segmentation: 'Particular o profesional'
}
/** `2026-01` → «enero de 2026»; cualquier otro formato se muestra tal cual. */
function cohortLabel(cohort: string): string {
  const match = /^(\d{4})-(\d{2})$/.exec(cohort)
  if (!match) return cohort
  const text = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, 1)).toLocaleDateString('es-ES', {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC'
  })
  return text.charAt(0).toUpperCase() + text.slice(1)
}

onMounted(() => {
  if (isAuthorized.value) {
    void fetchCohorts()
  }
})
</script>

<template>
  <div class="adm-stack">
    <AdminCard v-if="!isAuthorized">
      <AdminEmptyState
        icon="i-lucide-lock"
        title="Estos datos no están disponibles ahora"
        description="Necesitas la sesión iniciada, el correo verificado y la verificación en dos pasos, y solo se pueden consultar en la tienda publicada."
      />
    </AdminCard>
    <template v-else>
      <form class="adm-toolbar" aria-label="Filtros de clientes que repiten" @submit.prevent="fetchCohorts">
        <AdminFilters v-model="preset" :options="presetOptions" label="Periodo" />
        <label for="cohorts-from" class="adm-help">Desde</label>
        <input id="cohorts-from" v-model="fromDate" type="date" class="adm-input w-auto" @change="onDateChange" />
        <label for="cohorts-to" class="adm-help">Hasta</label>
        <input id="cohorts-to" v-model="toDate" type="date" class="adm-input w-auto" @change="onDateChange" />
        <label for="cohorts-segment" class="sr-only">Tipo de cliente</label>
        <select id="cohorts-segment" v-model="selectedSegment" class="adm-input w-auto" @change="fetchCohorts">
          <option value="all">Todos los clientes</option>
          <option value="particular">Particulares</option>
          <option value="professional">Profesionales</option>
        </select>
        <label for="cohorts-churn" class="adm-help">Cliente perdido tras</label>
        <input
          id="cohorts-churn"
          v-model.number="churnDays"
          type="number"
          min="1"
          max="730"
          class="adm-input w-20"
          @change="fetchCohorts"
        />
        <span class="adm-help">días sin comprar</span>
        <button
          type="submit"
          class="sr-only"
          tabindex="-1"
          :disabled="loading"
          data-testid="cohorts-apply"
          @click.prevent="fetchCohorts"
        >
          Aplicar filtros
        </button>
        <div class="adm-toolbar__end">
          <button
            type="button"
            class="adm-btn adm-btn--secondary"
            :disabled="loading"
            data-testid="cohorts-refresh"
            @click="fetchCohorts"
          >
            <UIcon name="i-lucide-rotate-cw" class="size-4" :class="loading && 'animate-spin'" />Actualizar
          </button>
        </div>
      </form>

      <AdminCard v-if="error">
        <AdminEmptyState
          role="alert"
          data-testid="cohorts-error"
          variant="error"
          title="No hemos podido cargar los clientes que repiten"
          description="Vuelve a intentarlo en unos segundos."
        >
          <AdminButton icon="i-lucide-rotate-cw" @click="fetchCohorts">Reintentar</AdminButton>
        </AdminEmptyState>
      </AdminCard>

      <div v-else-if="loading && !data" class="adm-grid" aria-busy="true">
        <span class="sr-only">Cargando…</span>
        <div
          v-for="row in 4"
          :key="row"
          class="h-28 animate-pulse rounded-[var(--radius-surface)] bg-[var(--surface-sunken)]"
        />
      </div>

      <template v-if="data">
        <div class="adm-grid">
          <div class="adm-card adm-stat">
            <p class="adm-stat__label"><UIcon name="i-lucide-users" class="size-4" />Clientes analizados</p>
            <p class="adm-stat__value" data-testid="metric-total-customers">{{ data.summary.totalCustomers }}</p>
            <p class="adm-stat__foot">Con al menos una compra</p>
          </div>
          <div class="adm-card adm-stat">
            <p class="adm-stat__label"><UIcon name="i-lucide-repeat" class="size-4" />Vuelven a comprar</p>
            <p class="adm-stat__value" data-testid="metric-repeat-rate">
              {{ formatPercent(data.summary.overallRepeatRate) }}
            </p>
            <p class="adm-stat__foot">{{ data.summary.totalRepeatCustomers }} clientes han repetido</p>
          </div>
          <div class="adm-card adm-stat">
            <p class="adm-stat__label"><UIcon name="i-lucide-calendar-clock" class="size-4" />Tiempo hasta repetir</p>
            <p class="adm-stat__value" data-testid="metric-median-days">
              {{ data.summary.medianDaysToRepurchase !== null ? `${data.summary.medianDaysToRepurchase} días` : '—' }}
            </p>
            <p class="adm-stat__foot">La mitad de los clientes repite antes</p>
          </div>
          <div class="adm-card adm-stat">
            <p class="adm-stat__label"><UIcon name="i-lucide-user-x" class="size-4" />Clientes perdidos</p>
            <p class="adm-stat__value" data-testid="metric-churn-rate">
              {{ formatPercent(data.summary.overallChurnRate) }}
            </p>
            <p class="adm-stat__foot">Llevan {{ data.filters.churnDays }} días o más sin comprar</p>
          </div>
        </div>

        <AdminCard
          flush
          title="Repetición según el mes de la primera compra"
          description="De los clientes que compraron por primera vez cada mes, cuántos han vuelto a comprar y en qué plazo."
        >
          <AdminEmptyState
            v-if="data.cohorts.length === 0"
            data-testid="cohorts-empty"
            icon="i-lucide-users"
            title="Sin pedidos en este periodo"
            description="No hay pedidos válidos para calcular la repetición en el rango seleccionado."
          />
          <div v-else class="adm-table-wrap">
            <table class="adm-table" data-testid="cohorts-table">
              <thead>
                <tr>
                  <th scope="col">Primera compra</th>
                  <th scope="col" data-numeric>Clientes</th>
                  <th scope="col" data-numeric>Repiten en 30 días</th>
                  <th scope="col" data-numeric>En 60 días</th>
                  <th scope="col" data-numeric>En 90 días</th>
                  <th scope="col" data-numeric>En 180 días</th>
                  <th scope="col" data-numeric>Tiempo hasta repetir</th>
                  <th scope="col" data-numeric>Perdidos</th>
                  <th scope="col">Particulares / profesionales</th>
                  <th scope="col">Categorías más compradas</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="c in data.cohorts" :key="c.cohort">
                  <th scope="row" class="whitespace-nowrap">{{ cohortLabel(c.cohort) }}</th>
                  <td data-numeric>{{ c.size }}</td>
                  <td
                    v-for="(span, index) in [c.repeat30Days, c.repeat60Days, c.repeat90Days, c.repeat180Days]"
                    :key="index"
                    data-numeric
                    class="whitespace-nowrap"
                  >
                    <span class="font-semibold text-[var(--text-strong)]">{{ formatPercent(span.rate) }}</span>
                    <span class="adm-help ml-1">({{ span.count }})</span>
                  </td>
                  <td data-numeric class="whitespace-nowrap">
                    {{ c.medianDaysToRepurchase !== null ? `${c.medianDaysToRepurchase} días` : '—' }}
                  </td>
                  <td data-numeric class="whitespace-nowrap">
                    <span class="font-semibold text-[var(--text-strong)]">{{ formatPercent(c.churn.rate) }}</span>
                    <span class="adm-help ml-1">({{ c.churn.count }})</span>
                  </td>
                  <td class="adm-help whitespace-nowrap">
                    <div>
                      {{ c.segments.particular.count }} particulares, repiten
                      {{ formatPercent(c.segments.particular.repeatRate) }}
                    </div>
                    <div>
                      {{ c.segments.professional.count }} profesionales, repiten
                      {{ formatPercent(c.segments.professional.repeatRate) }}
                    </div>
                  </td>
                  <td class="adm-help">
                    <div v-for="cat in c.topCategories" :key="cat.categoryId" class="max-w-[12rem] truncate">
                      {{ cat.categoryName }}: {{ cat.customerCount }}
                    </div>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </AdminCard>

        <details>
          <summary>Cómo se calculan estas cifras</summary>
          <dl class="mt-3 grid gap-x-6 gap-y-3 md:grid-cols-2">
            <div v-for="(desc, title) in data.definitions" :key="title">
              <dt class="font-semibold text-[var(--text-strong)]">
                {{ definitionLabels[String(title)] ?? adminHumanize(String(title)) }}
              </dt>
              <dd class="adm-help">{{ desc }}</dd>
            </div>
          </dl>
          <p class="adm-help mt-3">Versión de las definiciones: {{ data.definitionVersion }}</p>
        </details>
      </template>
    </template>
  </div>
</template>
